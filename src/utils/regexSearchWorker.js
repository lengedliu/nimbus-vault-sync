const { parentPort, workerData } = require('node:worker_threads');

let matcher;
try {
  matcher = new RegExp(workerData.query, workerData.caseSensitive ? 'g' : 'gi');
} catch (err) {
  parentPort.postMessage({ error: `Invalid regular expression: ${err.message}` });
}

parentPort.on('message', ({ path, lines, startLine }) => {
  if (!matcher) return;
  try {
    const matches = [];
    for (let offset = 0; offset < lines.length; offset++) {
      const line = lines[offset];
      if (line.length > workerData.maxLineLength) {
        throw new Error(`Line ${startLine + offset} in "${path}" exceeds the regex search line limit.`);
      }
      matcher.lastIndex = 0;
      if (matcher.test(line)) {
        matches.push({ path, lineNumber: startLine + offset, snippet: line.trim() });
      }
    }
    parentPort.postMessage({ matches });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
});
