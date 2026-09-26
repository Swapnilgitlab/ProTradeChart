import { describe, expect, it } from 'vitest';
import { nextScriptName, STARTER_SCRIPT, withPyExtension } from './scriptNames';

describe('nextScriptName', () => {
  it('starts with untitled.py', () => {
    expect(nextScriptName([])).toBe('untitled.py');
    expect(nextScriptName(['hello.py'])).toBe('untitled.py');
  });

  it('numbers from 2 when the name is taken, and skips every taken number', () => {
    expect(nextScriptName(['untitled.py'])).toBe('untitled 2.py');
    expect(nextScriptName(['untitled.py', 'untitled 2.py', 'untitled 3.py'])).toBe('untitled 4.py');
    expect(nextScriptName(['untitled.py', 'untitled 3.py'])).toBe('untitled 2.py');
  });

  it('compares without regard to case, as the file system does', () => {
    expect(nextScriptName(['Untitled.PY'])).toBe('untitled 2.py');
  });

  it('takes another base name', () => {
    expect(nextScriptName(['rsi.py'], 'rsi')).toBe('rsi 2.py');
  });
});

describe('withPyExtension', () => {
  it('adds the extension and trims', () => {
    expect(withPyExtension('  screen ')).toBe('screen.py');
    expect(withPyExtension('my scan')).toBe('my scan.py');
  });

  it('leaves a name that already ends in .py, putting the extension in lower case', () => {
    expect(withPyExtension('screen.py')).toBe('screen.py');
    expect(withPyExtension('screen.PY')).toBe('screen.py');
    expect(withPyExtension(' a.Py ')).toBe('a.py');
  });

  it('leaves nothing typed as nothing, so the caller can tell', () => {
    expect(withPyExtension('')).toBe('');
    expect(withPyExtension('   ')).toBe('');
  });

  it('only adds to a dotted name, never treats .py inside it as the end', () => {
    expect(withPyExtension('v1.2')).toBe('v1.2.py');
    expect(withPyExtension('a.pyc')).toBe('a.pyc.py');
  });
});

describe('the starter script', () => {
  it('imports the client and asks for bars', () => {
    expect(STARTER_SCRIPT).toContain('import protrade as pt');
    expect(STARTER_SCRIPT).toContain('pt.bars(');
  });
});
