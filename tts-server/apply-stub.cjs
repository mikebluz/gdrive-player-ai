// Overwrite EVERY installed copy of onnxruntime-node with the stub — npm nests a
// real copy under packages that pin an exact version (transformers pins 1.24.3),
// so one top-level overwrite is not enough. Walk the whole tree, depth-bounded.
const fs = require('fs'), path = require('path');
const STUBS = { 'onnxruntime-node': path.join(__dirname, 'stub', 'onnxruntime-node'),
                'sharp': path.join(__dirname, 'stub', 'sharp') };
const hits = [];
(function walk(dir, depth) {
  if (depth > 7) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin') continue;
    const p = path.join(dir, e.name);
    if (STUBS[e.name]) { hits.push([p, STUBS[e.name]]); continue; }
    walk(p, depth + 1);
  }
})(path.join(__dirname, 'node_modules'), 0);
for (const [p, stub] of hits) {
  fs.rmSync(p, { recursive: true, force: true });
  fs.cpSync(stub, p, { recursive: true });
  console.log('[stub] replaced ' + path.relative(__dirname, p));
}
if (!hits.length) console.log('[stub] no copies found');
