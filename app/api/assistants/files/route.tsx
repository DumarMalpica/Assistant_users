import { openai } from "@/app/openai";
import { toFile } from "openai/uploads";

export const runtime = "nodejs";

const FIXED_VECTOR_STORE_ID = "vs_69050fe6e43c8191be28bac47c3f565f";

// Helper: convertir Web ReadableStream en AsyncIterable<Uint8Array>
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

// Helper: ArrayBuffer -> base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // Node.js / Next.js runtime
  // eslint-disable-next-line no-undef
  if (typeof Buffer !== "undefined") {
    // @ts-ignore Buffer global in Node
    return Buffer.from(buffer).toString("base64");
  }

  // Fallback para otros runtimes
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // @ts-ignore btoa puede existir en entornos tipo browser
  return btoa(binary);
}

// EXTRA NODE: extraer texto de una IMAGEN usando GPT-4o-mini (visión)
async function extractTextFromImage(file: any): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);
  const mimeType = file.type || "image/png";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Extract ALL readable text that appears in this image. " +
              "Return ONLY the raw text, no explanations, no formatting, no translation.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  return "";
}

// Decide cómo vamos a subir el archivo al vector store:
// - Si es imagen -> la convertimos a TXT usando GPT-4o-mini y subimos ese texto.
// - Si no es imagen -> se sube tal cual (con opción de streaming para archivos grandes).
async function prepareUploadForVectorStore(
  file: any,
  url: URL
): Promise<{
  uploadable: any;
  filename: string;
}> {
  const mimeType = file.type || "";
  const isImage = mimeType.startsWith("image/");

  if (isImage) {
    const extractedText = await extractTextFromImage(file);

    const textBlob = new Blob([extractedText], {
      type: "text/plain",
    });

    const baseName = (file.name || "image").replace(/\.[^/.]+$/, "");
    const txtName = `${baseName}.txt`;

    return {
      uploadable: textBlob,
      filename: txtName,
    };
  }

  const useStreamParam = url.searchParams.get("stream");
  const useStream =
    useStreamParam === "true" || (file.size ?? 0) > 5 * 1024 * 1024; // ~5MB

  if (useStream && typeof file.stream === "function") {
    const webStream = file.stream() as ReadableStream<Uint8Array>;
    const iterable = toAsyncIterable(webStream);

    return {
      uploadable: iterable,
      filename: file.name || "upload.bin",
    };
  }

  // Upload normal (Blob-like)
  return {
    uploadable: file,
    filename: file.name || "upload.bin",
  };
}

/* === UPLOAD FILE ===
 *
 * - Si el archivo es IMAGEN:
 *   -> usa GPT-4o-mini visión para extraer texto
 *   -> genera un .txt
 *   -> sube el .txt al vector store.
 *
 * - Si no es imagen:
 *   -> comportamiento anterior (con streaming opcional para grandes).
 */
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file") as any;

  if (!file || typeof file.arrayBuffer !== "function") {
    return new Response("No file provided or invalid file", { status: 400 });
  }

  try {
    const url = new URL(request.url);

    const { uploadable, filename } = await prepareUploadForVectorStore(
      file,
      url
    );

    // Siempre usamos toFile para convertir lo que tengamos (Blob, AsyncIterable, etc.)
    const fileForUpload = await toFile(uploadable, filename);

    // Subimos el archivo ya “preprocesado” (imagen -> texto, o file original)
    const openaiFile = await openai.files.create({
      file: fileForUpload,
      purpose: "assistants",
    });

    // Asociar al vector store (indexación asíncrona)
    const vectorFile = await openai.beta.vectorStores.files.create(
      FIXED_VECTOR_STORE_ID,
      {
        file_id: openaiFile.id,
      }
    );

    console.log(
      `✅ Archivo ${openaiFile.filename} (preprocesado si era imagen) agregado al storage ${FIXED_VECTOR_STORE_ID} con estado ${vectorFile.status}`
    );

    return Response.json({
      message:
        "Archivo cargado (con preprocesamiento si era imagen) y en proceso de indexación",
      file_id: openaiFile.id,
      filename: openaiFile.filename,
      vector_file_id: vectorFile.id,
      status: vectorFile.status,
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
    return new Response("Archivo eliminado correctamente", { status: 200 });
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
