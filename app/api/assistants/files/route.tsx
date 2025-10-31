import { openai } from "@/app/openai";

const FIXED_VECTOR_STORE_ID = "vs_69050fe6e43c8191be28bac47c3f565f";

/* === UPLOAD FILE === */
export async function POST(request) {
  const formData = await request.formData();
  const file = formData.get("file");

  try {
    // Subir el archivo al storage general de OpenAI
    const openaiFile = await openai.files.create({
      file: file,
      purpose: "assistants",
    });

    // Asociarlo al vector store fijo
    await openai.beta.vectorStores.files.create(FIXED_VECTOR_STORE_ID, {
      file_id: openaiFile.id,
    });

    console.log(`✅ Archivo ${openaiFile.filename} agregado al storage ${FIXED_VECTOR_STORE_ID}`);
    return new Response("Archivo cargado correctamente");
  } catch (error) {
    console.error("❌ Error subiendo archivo:", error);
    return new Response("Error al subir archivo", { status: 500 });
  }
}

/* === LIST FILES (usa el storage fijo) === */
export async function GET() {
  try {
    // Intentar listar los archivos del vector store
    const fileList = await openai.beta.vectorStores.files.list(FIXED_VECTOR_STORE_ID);

    if (!fileList.data || fileList.data.length === 0) {
      console.log(`⚠️ No hay archivos dentro del storage ${FIXED_VECTOR_STORE_ID}`);
      return Response.json([]);
    }

    const filesArray = [];

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
      } catch (error) {
        if (error.status === 404) {
          //console.log(`🧹 Limpiando archivo inexistente: ${file.id}`);
          await openai.beta.vectorStores.files.del(FIXED_VECTOR_STORE_ID, file.id);
        } else {
          console.warn(`⚠️ Error obteniendo detalles de archivo ${file.id}:`, error.message);
        }
      }
    }

    return Response.json(filesArray);
  } catch (error) {
    if (error.status === 404) {
      console.warn(`⚠️ El storage ${FIXED_VECTOR_STORE_ID} no existe o no es accesible`);
      return Response.json([]);
    }

    console.error("❌ Error listando archivos:", error);
    return new Response("Error al listar archivos", { status: 500 });
  }
}

/* === DELETE FILE === */
export async function DELETE(request) {
  const body = await request.json();
  const fileId = body.fileId;

  try {
    await openai.beta.vectorStores.files.del(FIXED_VECTOR_STORE_ID, fileId);
    console.log(`🗑️ Archivo ${fileId} eliminado del storage ${FIXED_VECTOR_STORE_ID}`);
    return new Response("Archivo eliminado correctamente");
  } catch (error) {
    if (error.status === 404) {
      console.warn(`⚠️ El archivo ${fileId} no existe, nada que eliminar`);
      return new Response("Archivo ya inexistente", { status: 200 });
    }

    console.error("❌ Error eliminando archivo:", error);
    return new Response("Error al eliminar archivo", { status: 500 });
  }
}
