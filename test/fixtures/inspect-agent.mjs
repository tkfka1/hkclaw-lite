const chunks = [];

for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const input = chunks.join('');
const historyNeedle = process.env.HKCLAW_LITE_EXPECT_HISTORY_NEEDLE || '';

process.stdout.write(
  [
    `hasSkills=${input.includes('Installed skills:')}`,
    `hasContext=${input.includes('Baseline context:')}`,
    `hasRuntime=${input.includes('Runtime context:')}`,
    `hasSession=${input.includes('Recent role session history:')}`,
    `hasHistoryNeedle=${historyNeedle ? input.includes(historyNeedle) : 'n/a'}`,
    `hasChannel=${input.includes('- discord channel: discord-main')}`,
    `raw=${process.env.HKCLAW_LITE_RAW_PROMPT || ''}`,
    `workdir=${process.env.HKCLAW_LITE_WORKDIR || ''}`,
  ].join('\n') + '\n',
);
