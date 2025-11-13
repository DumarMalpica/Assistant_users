import { openai } from "@/app/openai";

const FIXED_VECTOR_STORE_ID = "vs_69050fe6e43c8191be28bac47c3f565f";

// Helper: convert a Web ReadableStream into an AsyncIterable<Uint8Array>
async function* toAsyncIterable(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* === UPLOAD FILE ===
 *
 * - Sube el archivo al storage de OpenAI.
 * - Usa “streaming” (AsyncIterable) para archivos grandes o si se pasa ?stream=true.
 * - Asocia el archivo al vector store (indexación asíncrona).
 * - Devuelve JSON con file_id y status para hacer polling luego.
 */
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return new Response("No file provided", { status: 400 });
  }

  try {
    const url = new URL(request.url);
    const useStreamParam = url.searchParams.get("stream");
    const useStream =
      useStreamParam === "true" || file.size > 5 * 1024 * 1024; // ~5MB

    let openaiFile;

    if (useStream) {
      // Streaming upload para archivos grandes: convertir ReadableStream a Blob/File
      // porque el cliente espera un "Uploadable" (File/Blob/stream compatible), no un AsyncIterable.
      const webStream = file.stream() as ReadableStream<Uint8Array>;
      // Crear un Blob consumiendo el stream vía Response, luego construir un File para subir.
      const blob = await new Response(webStream).blob();
      const fileToUpload = new File([blob], file.name, { type: (file as File).type });

      openaiFile = await openai.files.create({
        file: fileToUpload,
        purpose: "assistants",
      });
    } else {
      // Upload normal para archivos pequeños/medianos
      openaiFile = await openai.files.create({
        file,
        purpose: "assistants",
      });
    }

    // Asociar al vector store (indexación asíncrona)
    const vectorFile = await openai.beta.vectorStores.files.create(
      FIXED_VECTOR_STORE_ID,
      {
        file_id: openaiFile.id,
      }
    );

    console.log(
      `✅ Archivo ${openaiFile.filename} agregado al storage ${FIXED_VECTOR_STORE_ID} con estado ${vectorFile.status}`
    );

    return Response.json({
      message: "Archivo cargado y en proceso de indexación",
      file_id: openaiFile.id,
      filename: openaiFile.filename,
      vector_file_id: vectorFile.id,
      status: vectorFile.status, // normalmente "in_progress"
    });
  } catch (error: any) {
    console.error("❌ Error subiendo archivo:", error);
    return new Response("Error al subir archivo", { status: 500 });
  }
}

/* === LIST / STATUS FILES (usa el storage fijo) ===
 *
 * - Si NO recibe query param -> lista todos los archivos del vector store.
 * - Si recibe ?fileId=XXX     -> devuelve solo el estado de ese archivo (para polling).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const fileId = url.searchParams.get("fileId");

    // Modo STATUS para un solo archivo (polling)
    if (fileId) {
      try {
        const fileDetails = await openai.files.retrieve(fileId);
        const vectorFileDetails = await openai.beta.vectorStores.files.retrieve(
          FIXED_VECTOR_STORE_ID,
          fileId
        );

        return Response.json({
          file_id: fileId,
          filename: fileDetails.filename,
          status: vectorFileDetails.status, // completed | in_progress | failed
          last_error: vectorFileDetails.last_error,
        });
      } catch (error: any) {
        if (error.status === 404) {
          console.warn(
            `⚠️ El archivo ${fileId} no existe en el vector store ${FIXED_VECTOR_STORE_ID}`
          );
          return new Response("File not found", { status: 404 });
        }
        console.error(
          `❌ Error obteniendo estado del archivo ${fileId}:`,
          error
        );
        return new Response("Error retrieving file status", { status: 500 });
      }
    }

    // Modo LISTA de todos los archivos
    const fileList = await openai.beta.vectorStores.files.list(
      FIXED_VECTOR_STORE_ID
    );

    if (!fileList.data || fileList.data.length === 0) {
      console.log(
        `⚠️ No hay archivos dentro del storage ${FIXED_VECTOR_STORE_ID}`
      );
      return Response.json([]);
    }

    const filesArray: Array<{
      file_id: string;
      filename: string;
      status: string;
    }> = [];

    for (const file of fileList.data) {
      try {
        const fileDetails = await openai.files.retrieve(file.id);
        const vectorFileDetails = await openai.beta.vectorStores.files.retrieve(
          FIXED_VECTOR_STORE_ID,
          file.id
        );

        filesArray.push({
          file_id: file.id,
          filename: fileDetails.filename,
          status: vectorFileDetails.status,
        });
      } catch (error: any) {
        if (error.status === 404) {
          // Limpiar referencias huérfanas
          await openai.beta.vectorStores.files.del(
            FIXED_VECTOR_STORE_ID,
            file.id
          );
        } else {
          console.warn(
            `⚠️ Error obteniendo detalles de archivo ${file.id}:`,
            error.message
          );
        }
      }
    }

    return Response.json(filesArray);
  } catch (error: any) {
    if (error.status === 404) {
      console.warn(
        `⚠️ El storage ${FIXED_VECTOR_STORE_ID} no existe o no es accesible`
      );
      return Response.json([]);
    }

    console.error("❌ Error listando archivos:", error);
    return new Response("Error al listar archivos", { status: 500 });
  }
}

/* === DELETE FILE === */
export async function DELETE(request: Request) {
  const body = await request.json();
  const fileId = body.fileId as string | undefined;

  if (!fileId) {
    return new Response("fileId is required", { status: 400 });
  }

  try {
    await openai.beta.vectorStores.files.del(FIXED_VECTOR_STORE_ID, fileId);
    console.log(
      `🗑️ Archivo ${fileId} eliminado del storage ${FIXED_VECTOR_STORE_ID}`
    );
    return new Response("Archivo eliminado correctamente");
  } catch (error: any) {
    if (error.status === 404) {
      console.warn(
        `⚠️ El archivo ${fileId} no existe, nada que eliminar en el storage`
      );
      return new Response("Archivo ya inexistente", { status: 200 });
    }

    console.error("❌ Error eliminando archivo:", error);
    return new Response("Error al eliminar archivo", { status: 500 });
  }
}
