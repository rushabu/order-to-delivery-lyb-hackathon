// Configuration from environment variables (DESIGN.md section 4.8).
// No value here is ever logged.

export interface AppConfig {
  port: number;
  jwtSecret: string;
  corsOrigins: string[];
  databaseFile: string;
  demoMode: boolean;
  seedSampleOrders?: boolean;
  tomTomApiKey?: string;
  /** Groq key for the order-tracking assistant. Without it the assistant answers 503. */
  groqApiKey?: string;
  groqModel?: string;
  /** Validate every response body against its Zod schema. On everywhere except production. */
  validateResponses: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 16) {
    throw new Error('JWT_SECRET must be set to at least 16 characters (see .env.example)');
  }
  return {
    port: Number(env.PORT ?? 4000),
    jwtSecret,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databaseFile: env.DATABASE_FILE ?? './data/control-tower.sqlite',
    demoMode: env.DEMO_MODE === 'true',
    seedSampleOrders: env.SEED_SAMPLE_ORDERS === 'true',
    tomTomApiKey: env.TOMTOM_API_KEY?.trim() || undefined,
    groqApiKey: env.GROQ_API_KEY?.trim() || undefined,
    groqModel: env.GROQ_MODEL?.trim() || undefined,
    validateResponses: env.NODE_ENV !== 'production',
  };
}
