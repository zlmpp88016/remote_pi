import { createServer } from "node:http";
const s = createServer((req, res) => {
  console.log(req.method, req.url, "| sec-fetch-site:", req.headers["sec-fetch-site"], "| origin:", req.headers.origin, "| cookie:", (req.headers.cookie ?? "").slice(0,40), "| host:", req.headers.host);
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
  res.end("ok");
});
s.listen(4199, "127.0.0.1", () => console.log("probe on 4199"));
setTimeout(() => process.exit(0), 25000);
