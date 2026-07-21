// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Shared HTTP status codes. The single source of truth for both the client code
// and its tests — no raw status literals anywhere else.
export const HTTP_OK = 200;
export const HTTP_ACCEPTED = 202;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_SERVER_ERROR = 500; // non-retryable (deterministic)
export const HTTP_BAD_GATEWAY = 502; // retryable transient 5xx
export const HTTP_SERVICE_UNAVAILABLE = 503; // retryable transient 5xx
export const HTTP_GATEWAY_TIMEOUT = 504; // retryable transient 5xx
