import { hash, verify, parseOptions } from '@node-rs/argon2';

const DEFAULTS = { m: 19456, t: 2, p: 1 } as const;
const ARGON2ID = 2; // Algorithm.Argon2id

function getOptions() {
  return {
    memoryCost: DEFAULTS.m,
    timeCost: DEFAULTS.t,
    parallelism: DEFAULTS.p,
    algorithm: ARGON2ID,
  };
}

async function hashPassword(password: string): Promise<string> {
  return hash(password, getOptions());
}

async function verifyPassword(password: string, hashStr: string): Promise<boolean> {
  try {
    return await verify(hashStr, password);
  } catch {
    return false;
  }
}

async function benchmark() {
  const password = 'test-password-12345-あいうえお-ABCDEFG';
  const iterations = 10;

  console.log('=== Argon2id 負荷テスト ===');
  console.log(`パスワード: ${password}`);
  console.log(`反復回数: ${iterations}`);
  console.log('');

  const params = getOptions();
  console.log(`パラメータ: m=${params.memoryCost}, t=${params.timeCost}, p=${params.parallelism}`);
  console.log('');

  // メモリ測定用
  if (global.gc) global.gc();
  const memBefore = process.memoryUsage().heapUsed;

  // hash時間測定
  const hashStart = performance.now();
  const hashes: string[] = [];
  for (let i = 0; i < iterations; i++) {
    const h = await hashPassword(password);
    hashes.push(h);
  }
  const hashTime = performance.now() - hashStart;

  // verify時間測定
  const verifyStart = performance.now();
  for (const h of hashes) {
    await verifyPassword(password, h);
  }
  const verifyTime = performance.now() - verifyStart;

  if (global.gc) global.gc();
  const memAfter = process.memoryUsage().heapUsed;

  const avgHashMs = hashTime / iterations;
  const avgVerifyMs = verifyTime / iterations;
  const memoryDeltaMB = (memAfter - memBefore) / 1024 / 1024;

  console.log('--- 結果 ---');
  console.log(`平均hash時間: ${avgHashMs.toFixed(2)} ms`);
  console.log(`平均verify時間: ${avgVerifyMs.toFixed(2)} ms`);
  console.log(`メモリ増分: ${memoryDeltaMB.toFixed(2)} MB`);
  console.log('');

  // 目標判定
  const targetHashMs = 100;
  const targetMemMB = 256;
  const hashOk = avgHashMs <= targetHashMs * 1.5; // 1.5倍まで許容
  const memOk = memoryDeltaMB <= targetMemMB;

  console.log('--- 目標判定 ---');
  console.log(`Hash時間目標: ${targetHashMs}ms 以下 -> ${hashOk ? '達成' : '未達成'} (${avgHashMs.toFixed(2)}ms)`);
  console.log(`メモリ目標: ${targetMemMB}MB 以下 -> ${memOk ? '達成' : '未達成'} (${memoryDeltaMB.toFixed(2)}MB)`);
  console.log('');

  if (!hashOk || !memOk) {
    console.log('⚠️  目標未達成 - 調整案:');
    if (!hashOk) {
      console.log('  - m (メモリコスト) を下げる: 現在 19456 -> 15360 程度');
      console.log('  - t (時間コスト) を下げる: 現在 2 -> 1');
    }
    if (!memOk) {
      console.log('  - m (メモリコスト) を下げる: 現在 19456 -> 12288 程度');
    }
  } else {
    console.log('✅ 目標達成');
  }

  // 記録用JSON出力
  console.log('');
  console.log('--- 記録用JSON ---');
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    passwordLength: password.length,
    iterations,
    params: { m: params.memoryCost, t: params.timeCost, p: params.parallelism },
    results: {
      avgHashMs: Number(avgHashMs.toFixed(2)),
      avgVerifyMs: Number(avgVerifyMs.toFixed(2)),
      memoryDeltaMB: Number(memoryDeltaMB.toFixed(2)),
    },
    targets: {
      hashMs: targetHashMs,
      memMB: targetMemMB,
    },
    verdict: hashOk && memOk ? 'PASS' : 'FAIL',
  }, null, 2));
}

benchmark().catch(console.error);