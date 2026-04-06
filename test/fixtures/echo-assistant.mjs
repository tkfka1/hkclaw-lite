const chunks = [];

for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const input = chunks.join('');
const match = input.match(/User request:\n([\s\S]*)$/u);
const request = match ? match[1].trim() : input.trim();

process.stdout.write(
  `response=${request.toUpperCase()}\n`,
);
