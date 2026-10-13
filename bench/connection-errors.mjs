// Retry POST only when every socket attempt failed before connection.
export function neverConnected(error) {
  const cause = error instanceof Error ? error.cause : undefined;
  const attempts = cause instanceof AggregateError ? cause.errors : [cause];
  return (
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        attempt instanceof Error &&
        attempt.syscall === "connect" &&
        ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(attempt.code),
    )
  );
}
