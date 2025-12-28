import { describe, it } from 'node:test'
import assert from 'node:assert'
import { padOrTruncate, shortenAddress, TREE_W_CHARS } from './utils.js'

describe('padOrTruncate', () => {
  it('pads short strings', () => {
    assert.strictEqual(padOrTruncate('abc', 6), 'abc   ')
    assert.strictEqual(padOrTruncate('', 3), '   ')
  })

  it('returns string unchanged if exact length', () => {
    assert.strictEqual(padOrTruncate('abcdef', 6), 'abcdef')
  })

  it('truncates and adds ellipsis for long strings', () => {
    assert.strictEqual(padOrTruncate('abcdefgh', 6), 'abcde…')
    assert.strictEqual(padOrTruncate('toolongstring', 10), 'toolongst…')
  })

  it('uses configured width', () => {
    const result = padOrTruncate('test', TREE_W_CHARS)
    assert.strictEqual(result.length, TREE_W_CHARS)
  })
})

describe('shortenAddress', () => {
  it('shortens long addresses', () => {
    assert.strictEqual(shortenAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234...5678')
  })

  it('returns short addresses unchanged', () => {
    assert.strictEqual(shortenAddress('0x1234'), '0x1234')
  })
})
