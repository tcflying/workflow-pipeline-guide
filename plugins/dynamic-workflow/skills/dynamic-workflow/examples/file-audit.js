export const meta = {
  name: 'file-audit',
  description: 'Audit each file from several angles, then merge the findings that survive',
  whenToUse: 'When a set of files needs the same review questions asked of every one of them',
  args: {
    files: { type: 'array', required: true, description: 'paths to audit, relative to the workspace' },
    angles: { type: 'array', default: ['correctness', 'security'] },
  },
};

const isText = (v) => typeof v === 'string';

phase('Audit');
const perFile = await pipeline(
  args.files,
  (file) =>
    parallel(
      args.angles.map((angle) => () => agent(`Read ${file}. Audit it for ${angle} issues only.
List each finding as: path:line - what breaks - how to fix. Say "none" if there is nothing real.`))
    ),
  (answers, file) => ({ file, findings: answers.filter(isText).join('\n') })
);

phase('Merge');
const merged = await agent(
  `Here are audit findings per file. Drop anything that is not a real defect, keep the rest.
${perFile.map((p) => `## ${p.file}\n${p.findings}`).join('\n')}`,
  { json: false }
);

return { audited: perFile.length, skipped: perFile.filter((p) => !p.findings).length, merged };
