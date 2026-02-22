import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pr-guardian/common': path.resolve(__dirname, '../../packages/common/src/index.ts'),
      '@pr-guardian/domain': path.resolve(__dirname, '../../packages/domain/src/index.ts'),
      '@pr-guardian/app-server-client': path.resolve(__dirname, '../../packages/app-server-client/src/index.ts')
    }
  }
});
