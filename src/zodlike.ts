// Shared zod-compatible surface (host `pi.zod` is a Zod-compatible builder
// backed by omptype). Loose interface: chains type-check, host validates.

export interface ZodLike {
  object(shape: Record<string, unknown>): unknown;
  string(): ZodLike;
  boolean(): ZodLike;
  enum(values: string[]): ZodLike;
  array(item?: unknown): ZodLike;
  optional(): ZodLike;
  describe(d: string): ZodLike;
}
