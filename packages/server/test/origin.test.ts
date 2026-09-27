import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../src/index';

describe('isAllowedOrigin', () => {
  it.each([
    'https://orakgarak.vercel.app',
    'https://orak-garak.vercel.app',
    'https://orak-garak-p3wzzg48h-akashas-projects-678d129e.vercel.app',
    'http://localhost:5173',
  ])('allows %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each([
    'https://evil.vercel.app',
    'https://orakgarak.vercel.app.evil.com',
    'http://orakgarak.vercel.app',
  ])('rejects %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });
});
