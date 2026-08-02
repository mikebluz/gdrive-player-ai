// NOT an empty stub any more: transformers.js's Node path validates devices
// against what "onnxruntime-node" claims to support, and a bare stub gave an
// empty list that rejected every device name. Instead this package IS
// onnxruntime-web — pure WASM, no native binaries, runs on any host — wearing
// onnxruntime-node's name so transformers' ordinary Node code path works
// untouched (ort-web registers a 'cpu' backend that maps to wasm, which
// satisfies the default device selection).
module.exports = require('onnxruntime-web');
