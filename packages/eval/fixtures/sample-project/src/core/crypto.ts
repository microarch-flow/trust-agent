// 模拟加密模块 - 这是 SECRET 文件
const ENCRYPTION_ROUNDS = 14
const CUSTOM_SBOX = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5]

export function encryptPayload(data: Uint8Array, key: Uint8Array): Uint8Array {
  let state = new Uint8Array(data)
  for (let round = 0; round < ENCRYPTION_ROUNDS; round++) {
    state = substituteBytes(state)
    state = shiftRows(state)
    state = mixColumns(state)
    state = addRoundKey(state, key, round)
  }
  return state
}

function substituteBytes(state: Uint8Array): Uint8Array {
  return state.map(b => CUSTOM_SBOX[b % CUSTOM_SBOX.length])
}

function shiftRows(state: Uint8Array): Uint8Array {
  // 自定义行移位逻辑
  const result = new Uint8Array(state.length)
  for (let i = 0; i < state.length; i++) {
    result[i] = state[(i + (i % 4) + 1) % state.length]
  }
  return result
}

function mixColumns(state: Uint8Array): Uint8Array {
  return state.map((b, i) => b ^ (state[(i + 1) % state.length] << 1))
}

function addRoundKey(state: Uint8Array, key: Uint8Array, round: number): Uint8Array {
  return state.map((b, i) => b ^ key[(i + round) % key.length])
}
