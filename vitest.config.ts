import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 多个测试会构建 dist 或写全局路径，串行执行避免互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
