// Local dev server: serves the real Worker code over HTTP with a stubbed Workers AI binding.
// Run with: node test/dev-server.mjs [port]
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import worker from "../src/worker.js";

const port = Number(process.argv[2] || 8898);

// Minimal PNG encoder so the stub returns a real, decodable image.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = Math.round((x / width) * 255);
      raw[i + 1] = Math.round((y / height) * 255);
      raw[i + 2] = 140;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const env = {
  BRIDGE_TOKEN: process.env.BRIDGE_TOKEN || "local-dev-token",
  // Pass MODELS_JSON to exercise a custom registry without editing config/models.json.
  ...(process.env.MODELS_JSON ? { MODELS_JSON: process.env.MODELS_JSON } : {}),
  AI: {
    async run(model, input) {
      let width = input.width || 1024;
      let height = input.height || 768;
      if (input.multipart) {
        const parsed = await new Response(input.multipart.body, {
          headers: { "content-type": input.multipart.contentType },
        }).formData();
        width = Number(parsed.get("width")) || width;
        height = Number(parsed.get("height")) || height;
        console.log(`[ai] ${model} multipart: fields=${[...parsed.keys()].join(",")} ${width}x${height}`);
      } else {
        console.log(`[ai] ${model} json: ${JSON.stringify({ ...input, prompt: String(input.prompt).slice(0, 40) })}`);
      }
      return { image: png(Math.min(width, 768), Math.min(height, 768)).toString("base64") };
    },
  },
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = `http://127.0.0.1:${port}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "POST" || req.method === "PUT" ? body : undefined,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`bridge dev server on http://127.0.0.1:${port}`));
