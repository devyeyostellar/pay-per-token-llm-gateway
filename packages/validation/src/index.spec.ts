import {
  chatCompletionRequestSchema,
  routeConfigSchema,
  routeUpdateSchema,
  quoteSchema,
  txHashSchema,
  stellarAddressSchema,
  verifyPaymentSchema,
} from './index';

describe('txHashSchema', () => {
  it('accepts a 64-char lowercase hex hash', () => {
    expect(
      txHashSchema.safeParse('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2')
        .success,
    ).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(
      txHashSchema.safeParse('A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2')
        .success,
    ).toBe(true);
  });

  it('rejects short, long, and non-hex strings', () => {
    expect(txHashSchema.safeParse('abc').success).toBe(false);
    expect(txHashSchema.safeParse('z'.repeat(64)).success).toBe(false);
    expect(txHashSchema.safeParse('a'.repeat(63)).success).toBe(false);
    expect(txHashSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(txHashSchema.safeParse('').success).toBe(false);
  });
});

describe('stellarAddressSchema', () => {
  it('accepts a well-formed Stellar public key', () => {
    expect(
      stellarAddressSchema.safeParse('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F')
        .success,
    ).toBe(true);
  });

  it('rejects invalid addresses', () => {
    expect(stellarAddressSchema.safeParse('not-an-address').success).toBe(false);
    expect(stellarAddressSchema.safeParse('S' + 'A'.repeat(55)).success).toBe(false); // secret, not public
    expect(stellarAddressSchema.safeParse('').success).toBe(false);
  });
});

describe('chatCompletionRequestSchema', () => {
  it('accepts a normal chat request', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
    });
    expect(result.success).toBe(true);
  });

  it('accepts streaming requests', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 128 messages (memory DoS bound)', () => {
    const messages = Array.from({ length: 129 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i}`,
    }));
    const result = chatCompletionRequestSchema.safeParse({ model: 'gpt-4', messages });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 128 messages', () => {
    const messages = Array.from({ length: 128 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i}`,
    }));
    const result = chatCompletionRequestSchema.safeParse({ model: 'gpt-4', messages });
    expect(result.success).toBe(true);
  });

  it('rejects message content longer than 64 KiB', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'x'.repeat(65_537) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_tokens larger than the bound', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 2_000_000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty messages and empty model', () => {
    expect(chatCompletionRequestSchema.safeParse({ model: 'gpt-4', messages: [] }).success).toBe(
      false,
    );
    expect(
      chatCompletionRequestSchema.safeParse({
        model: '',
        messages: [{ role: 'user', content: 'x' }],
      }).success,
    ).toBe(false);
  });
});

describe('routeConfigSchema', () => {
  const base = {
    providerId: '00000000-0000-4000-8000-000000000000',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4',
    acceptedAssets: ['USDC'],
  };

  it('accepts a flat route with a flat price', () => {
    expect(
      routeConfigSchema.safeParse({ ...base, pricingModel: 'flat', flatPrice: '1000000' }).success,
    ).toBe(true);
  });

  it('accepts a per-token route with a per-token price', () => {
    expect(
      routeConfigSchema.safeParse({
        ...base,
        pricingModel: 'per_token',
        perTokenPrice: '500',
      }).success,
    ).toBe(true);
  });

  it('rejects a flat route without a flat price (free access guard)', () => {
    const result = routeConfigSchema.safeParse({ ...base, pricingModel: 'flat' });
    expect(result.success).toBe(false);
  });

  it('rejects a per-token route without a per-token price', () => {
    const result = routeConfigSchema.safeParse({ ...base, pricingModel: 'per_token' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric prices (BigInt crash guard)', () => {
    expect(
      routeConfigSchema.safeParse({
        ...base,
        pricingModel: 'flat',
        flatPrice: 'abc',
      }).success,
    ).toBe(false);
    expect(
      routeConfigSchema.safeParse({
        ...base,
        pricingModel: 'flat',
        flatPrice: '-5',
      }).success,
    ).toBe(false);
  });

  it('rejects a path that does not start with /', () => {
    expect(
      routeConfigSchema.safeParse({
        ...base,
        pricingModel: 'flat',
        flatPrice: '100',
        path: 'chat/completions',
      }).success,
    ).toBe(false);
  });
});

describe('quoteSchema', () => {
  const baseQuote = {
    id: '00000000-0000-4000-8000-000000000000',
    route: '/v1/chat/completions',
    pricingModel: 'flat',
    amount: '1000000',
    asset: 'USDC',
    paymentAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    network: 'testnet',
    expiresAt: Date.now() / 1000 + 300,
    statusUrl: 'https://gateway.test/api/v1/payments/00000000-0000-4000-8000-000000000000/status',
  };

  it('accepts a quote with issuedAt (new format)', () => {
    expect(quoteSchema.safeParse({ ...baseQuote, issuedAt: Date.now() / 1000 }).success).toBe(true);
  });

  it('accepts a legacy quote without issuedAt (backward compat)', () => {
    expect(quoteSchema.safeParse(baseQuote).success).toBe(true);
  });

  it('rejects a quote with a non-positive expiry', () => {
    expect(quoteSchema.safeParse({ ...baseQuote, expiresAt: 0 }).success).toBe(false);
  });
});

describe('verifyPaymentSchema', () => {
  it('accepts a valid txHash + quoteId pair', () => {
    expect(
      verifyPaymentSchema.safeParse({
        txHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        quoteId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(true);
  });

  it('rejects non-uuid quote ids and garbage tx hashes', () => {
    expect(
      verifyPaymentSchema.safeParse({
        txHash: 'not-a-hash',
        quoteId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(false);
    expect(
      verifyPaymentSchema.safeParse({
        txHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        quoteId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });
});

describe('routeUpdateSchema', () => {
  it('allows partial updates', () => {
    expect(routeUpdateSchema.safeParse({ active: false }).success).toBe(true);
    expect(routeUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('rejects invalid prices in updates', () => {
    expect(routeUpdateSchema.safeParse({ flatPrice: '12x' }).success).toBe(false);
  });
});
