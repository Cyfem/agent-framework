import { describe, expect, it } from 'vitest';

import {
  assertPortableSkillLayout,
  compareSkillStrings,
  isPortableSkillLogicalId,
  isValidSkillName,
  normalizeSkillExtension,
  parseSkillCommand,
  renderSkillDiscoveryCatalog,
  renderSkillJsonString,
  renderSkillLoad,
} from '../src/agent/skill-command';

describe('Skill command parser', () => {
  it('treats omitted and ASCII-whitespace-only args as load', () => {
    expect(parseSkillCommand(undefined)).toEqual({
      ok: true,
      command: { kind: 'load', arguments: '' },
    });
    expect(parseSkillCommand(' \t\r\n ')).toEqual({
      ok: true,
      command: { kind: 'load', arguments: '' },
    });
  });

  it('preserves the load raw tail after consuming delimiter whitespace', () => {
    expect(parseSkillCommand(' \tload \r\n  "a b"\\tail  ')).toEqual({
      ok: true,
      command: { kind: 'load', arguments: '"a b"\\tail  ' },
    });
    expect(parseSkillCommand('load')).toEqual({
      ok: true,
      command: { kind: 'load', arguments: '' },
    });
    expect(parseSkillCommand('load "unterminated')).toEqual({
      ok: true,
      command: { kind: 'load', arguments: '"unterminated' },
    });
  });

  it('uses only TAB/LF/CR/SP as separators', () => {
    expect(parseSkillCommand('\u00a0load')).toEqual({
      ok: false,
      code: 'invalid_command',
    });
    expect(parseSkillCommand('load\u2028tail')).toEqual({
      ok: false,
      code: 'invalid_command',
    });
  });

  it('lexes read/run quotes, empty argv, escapes, and shell characters as plain data', () => {
    expect(parseSkillCommand(`read "references/a b.md"`)).toEqual({
      ok: true,
      command: { kind: 'read', resourceId: 'references/a b.md' },
    });
    expect(
      parseSkillCommand(`run scripts/check.py '' "two words" escaped\\ value ';' '&&' '$()'`),
    ).toEqual({
      ok: true,
      command: {
        kind: 'run',
        scriptId: 'scripts/check.py',
        argv: ['', 'two words', 'escaped value', ';', '&&', '$()'],
      },
    });
    expect(parseSkillCommand(`read references/a\\ b.md`)).toEqual({
      ok: true,
      command: { kind: 'read', resourceId: 'references/a b.md' },
    });
    expect(parseSkillCommand(`run scripts/check.py escaped\\🚀 "quoted\\🧪"`)).toEqual({
      ok: true,
      command: {
        kind: 'run',
        scriptId: 'scripts/check.py',
        argv: ['escaped🚀', 'quoted🧪'],
      },
    });
  });

  it('requires quotes to wrap an entire token', () => {
    for (const input of [
      `read prefix"suffix"`,
      `read "prefix"suffix`,
      `run scripts/check.py 'first'"second"`,
      `run scripts/check.py bare'quoted'`,
    ]) {
      expect(parseSkillCommand(input)).toMatchObject({
        ok: false,
        code: 'invalid_arguments',
      });
    }

    expect(parseSkillCommand(`read "references/a b.md"\t`)).toEqual({
      ok: true,
      command: { kind: 'read', resourceId: 'references/a b.md' },
    });
  });

  it('reports command and argument syntax failures without returning raw input', () => {
    expect(parseSkillCommand('inspect references/a.md')).toEqual({
      ok: false,
      code: 'invalid_command',
    });
    expect(parseSkillCommand('read')).toEqual({
      ok: false,
      code: 'invalid_arguments',
      command: 'read',
    });
    expect(parseSkillCommand('read a b')).toEqual({
      ok: false,
      code: 'invalid_arguments',
      command: 'read',
    });
    expect(parseSkillCommand(`run "unterminated`)).toEqual({
      ok: false,
      code: 'invalid_arguments',
      command: 'run',
    });
    expect(parseSkillCommand('run scripts/a.py trailing\\')).toEqual({
      ok: false,
      code: 'invalid_arguments',
      command: 'run',
    });
    expect(parseSkillCommand('load safe\0unsafe')).toEqual({
      ok: false,
      code: 'invalid_arguments',
    });
  });
});

describe('Skill portable identifiers and layout', () => {
  it('validates lowercase Skill slugs and single extensions', () => {
    expect(isValidSkillName('invoice-review')).toBe(true);
    expect(isValidSkillName(`a${'-a'.repeat(31)}`)).toBe(true);
    for (const value of ['', '-skill', 'skill-', 'two--parts', 'UPPER', '中文']) {
      expect(isValidSkillName(value)).toBe(false);
    }
    expect(normalizeSkillExtension('.PY')).toBe('.py');
    expect(normalizeSkillExtension('.foo.py')).toBeUndefined();
    expect(normalizeSkillExtension('py')).toBeUndefined();
  });

  it('accepts portable nested ids and rejects traversal and cross-platform hazards', () => {
    expect(isPortableSkillLogicalId('references/examples/账单 policy.md')).toBe(true);
    expect(isPortableSkillLogicalId('scripts/check.py')).toBe(true);

    for (const value of [
      '',
      '/absolute.md',
      'references//a.md',
      'references/./a.md',
      'references/../a.md',
      'references/a\\b.md',
      'references/query?.md',
      'references/a:b.md',
      'references/trailing. ',
      'references/CON.txt',
      'scripts/lpt9.py',
      'references/control\u0001.md',
    ]) {
      expect(isPortableSkillLogicalId(value)).toBe(false);
    }
  });

  it('rejects per-directory case/NFC aliases and file-directory prefix conflicts', () => {
    expect(() =>
      assertPortableSkillLayout([
        { id: 'references/A/x.md', kind: 'resource' },
        { id: 'references/a/y.md', kind: 'resource' },
      ]),
    ).toThrow(/collision/iu);
    expect(() =>
      assertPortableSkillLayout([
        { id: 'references/é.md', kind: 'resource' },
        { id: 'references/e\u0301.md', kind: 'resource' },
      ]),
    ).toThrow(/collision/iu);
    expect(() =>
      assertPortableSkillLayout([
        { id: 'references/foo', kind: 'resource' },
        { id: 'references/foo/bar.md', kind: 'resource' },
      ]),
    ).toThrow(/prefix/iu);
    expect(() =>
      assertPortableSkillLayout([
        { id: 'references/foo/bar.md', kind: 'resource' },
        { id: 'references/foo', kind: 'resource' },
      ]),
    ).toThrow(/prefix/iu);
  });

  it('uses deterministic UTF-16 code-unit ordering', () => {
    // U+10000 begins with D800, which sorts before the BMP private-use U+E000 in UTF-16.
    expect(['\ue000', '\u{10000}'].sort(compareSkillStrings)).toEqual(['\u{10000}', '\ue000']);
  });
});

describe('Skill catalog and load rendering', () => {
  it('renders descriptions as one-line JSON literals', () => {
    const description = 'line 1\n"heading"\u2028next';
    expect(renderSkillJsonString(description)).toBe('"line 1\\n\\"heading\\"\\u2028next"');
    expect(renderSkillDiscoveryCatalog([{ name: 'invoice-review', description }])).toBe(
      '- invoice-review: "line 1\\n\\"heading\\"\\u2028next"',
    );
  });

  it('replaces every literal argument placeholder without replacement-pattern semantics', () => {
    const rendered = renderSkillLoad({
      name: 'invoice-review',
      instructions: 'first=$ARGUMENTS\nsecond=$ARGUMENTS',
      arguments: '$& / invoices/acme.json  ',
      resourceIds: ['references/a b.md'],
      scripts: [
        {
          id: 'scripts/check.py',
          available: true,
          description: 'line 1\n## injected',
        },
      ],
    });

    expect(rendered).toContain('first=$& / invoices/acme.json  \nsecond=$& / invoices/acme.json  ');
    expect(rendered).toContain('- "references/a b.md"');
    expect(rendered).toContain('- scripts/check.py [available] — "line 1\\n## injected"');
    expect(rendered).toContain('## Commands\n- read <resource-id>\n- run <script-id> [args...]');
  });

  it('appends an arguments block and preserves empty manifest sections', () => {
    const rendered = renderSkillLoad({
      name: 'empty-skill',
      instructions: '',
      arguments: 'raw tail ',
      resourceIds: [],
      scripts: [],
    });

    expect(rendered).toContain('## Instructions\nARGUMENTS:\nraw tail ');
    expect(rendered).toContain('## Resources\n- none');
    expect(rendered).toContain('## Scripts\n- none');
  });
});
