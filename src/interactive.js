import readline from 'node:readline/promises';

import { assert, parseCommaSeparatedList, readStdin } from './utils.js';

export async function withPrompter(callback) {
  if (!process.stdin.isTTY) {
    const lines = (await readStdin()).split(/\r?\n/u);
    let cursor = 0;
    const fakeRl = {
      question(prompt) {
        process.stdout.write(prompt);
        const answer = lines[cursor] ?? '';
        cursor += 1;
        return Promise.resolve(answer);
      },
      close() {},
    };
    return callback(createPrompter(fakeRl));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await callback(createPrompter(rl));
  } finally {
    rl.close();
  }
}

function createPrompter(rl) {
  return {
    askText: (label, options) => askText(rl, label, options),
    askChoice: (label, choices, options) => askChoice(rl, label, choices, options),
    askConfirm: (label, options) => askConfirm(rl, label, options),
    askList: (label, options) => askList(rl, label, options),
  };
}

async function askText(rl, label, options = {}) {
  const {
    defaultValue,
    allowEmpty = false,
    validate,
    transform = (value) => value,
  } = options;

  while (true) {
    const suffix =
      defaultValue !== undefined && defaultValue !== null && String(defaultValue) !== ''
        ? ` [${defaultValue}]`
        : '';
    const raw = await rl.question(`${label}${suffix}: `);
    const candidate = raw.trim() === '' ? defaultValue ?? '' : raw;
    const value = transform(String(candidate));

    if (!allowEmpty && String(value).trim() === '') {
      console.log('This field is required.');
      continue;
    }
    if (validate) {
      const validationResult = validate(value);
      if (validationResult !== true) {
        console.log(validationResult);
        continue;
      }
    }
    return String(value);
  }
}

async function askChoice(rl, label, choices, options = {}) {
  assert(Array.isArray(choices) && choices.length > 0, 'Choice list cannot be empty.');
  const defaultValue = options.defaultValue ?? choices[0].value;

  while (true) {
    console.log(label);
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}) ${choice.label} - ${choice.description}`);
    });

    const defaultIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.value === defaultValue),
    );
    const answer = await rl.question(`Select [${defaultIndex + 1}]: `);
    const normalized = answer.trim();

    if (normalized === '') {
      return choices[defaultIndex].value;
    }

    const index = Number.parseInt(normalized, 10);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1].value;
    }

    const directMatch = choices.find(
      (choice) =>
        choice.value === normalized ||
        choice.label.toLowerCase() === normalized.toLowerCase(),
    );
    if (directMatch) {
      return directMatch.value;
    }

    console.log('Pick a valid choice number or value.');
  }
}

async function askConfirm(rl, label, options = {}) {
  const defaultValue = options.defaultValue ?? true;

  while (true) {
    const prompt = defaultValue ? ' [Y/n]' : ' [y/N]';
    const answer = (await rl.question(`${label}${prompt}: `)).trim().toLowerCase();
    if (answer === '') {
      return defaultValue;
    }
    if (['y', 'yes'].includes(answer)) {
      return true;
    }
    if (['n', 'no'].includes(answer)) {
      return false;
    }
    console.log('Please answer yes or no.');
  }
}

async function askList(rl, label, options = {}) {
  const defaultValues = Array.isArray(options.defaultValue)
    ? options.defaultValue
    : parseCommaSeparatedList(options.defaultValue);
  const allowAll = options.allowAll ?? false;

  while (true) {
    const suffix = defaultValues.length > 0 ? ` [${defaultValues.join(', ')}]` : '';
    const answer = await rl.question(`${label}${suffix}: `);
    const raw = answer.trim() === '' ? defaultValues.join(', ') : answer;
    const values = parseCommaSeparatedList(raw);

    if (allowAll && values.length === 1 && values[0] === 'all') {
      return ['all'];
    }

    if (values.length > 0) {
      return values;
    }

    console.log('Enter at least one value.');
  }
}
