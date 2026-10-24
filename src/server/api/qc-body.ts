import { ValidationError } from "../authorization/errors";
export async function readQcBody(request: Request, limit = 1024 * 1024): Promise<unknown> {
  if (!request.body) throw new ValidationError("JSON body required");
  const reader = request.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ValidationError("Request metadata ceiling exceeded");
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Invalid JSON request");
  } finally {
    reader.releaseLock();
  }
}
