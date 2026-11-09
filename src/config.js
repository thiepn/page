// Public client configuration. OAuth registration is operator-only, NEVER automatic.
// Leave unconfigured and fail closed until app registry, public OAuth client,
// exact callback, and owner-scoped RLS/CAS migration have passed onboarding.
// No secret or service-role key may ever appear here.
export const ACCOUNT_ISSUER='https://hycegznamzjhwinegaai.supabase.co';
export const ACCOUNT_ORIGIN='https://account.thiepn.dev';
export const ACCOUNT_REDIRECT='https://page.thiepn.dev/auth/callback/';
export const ACCOUNT_CLIENT_ID=''; // reviewed client UUID after manual registration
export const ACCOUNT_PUBLISHABLE_KEY='sb_publishable_1rZzRPzfLMaAH5pIgCwIjA_19UPMIsR'; // public sb_publishable_... from account issuer
