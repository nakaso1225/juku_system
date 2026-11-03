export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ADMIN_EMAILS?: string;
  DEV_LOGIN?: string;
  COMIRU_TOKEN?: string;
  COMIRU_SCHOOL_ID?: string;
  /** テスト用。省略時は https://api.comiru.com */
  COMIRU_API_BASE_URL?: string;
}

/** ログイン中の Google アカウント */
export interface SessionUser {
  sub: string;
  email: string;
  name: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser };
};

export interface Term {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  periods: number[];
  closed_dates: string[];
  accepting: boolean;
}
