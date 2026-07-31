CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
  return_to TEXT NOT NULL CHECK (
    length(return_to) BETWEEN 1 AND 2048
    AND substr(return_to, 1, 1) = '/'
    AND substr(return_to, 1, 2) != '//'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL CHECK (length(user_id) = 68),
  github_user_id TEXT NOT NULL CHECK (length(github_user_id) BETWEEN 1 AND 20),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions(expires_at);
CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id);
