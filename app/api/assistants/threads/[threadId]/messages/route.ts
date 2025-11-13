import { assistantId } from "@/app/assistant-config";
import { openai } from "@/app/openai";

export const runtime = "nodejs";

const FIXED_VECTOR_STORE_ID = "vs_69050fe6e43c8191be28bac47c3f565f";

// Send a new message to a thread
export async function POST(request: Request, { params: { threadId } }: { params: { threadId: string } }) {
  const { content } = await request.json();

  // 1) Add user message
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content,
  });

  // 2) Start a run that EXPLICITLY uses the fixed vector store
  const stream = openai.beta.threads.runs.stream(threadId, {
    assistant_id: assistantId,
    // make sure file_search is available
    tools: [{ type: "file_search" }],
  });

  return new Response(stream.toReadableStream());
}
