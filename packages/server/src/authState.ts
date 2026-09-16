// Compatibility export until the reviewed control-plane switch-over. The parser
// is owned by tenancy so runtime loading and migration cannot disagree.
export {
  loadLegacyAuthState as loadAuthState,
  type LegacyCredential as StoredCredential,
  type LegacyAuthSession as StoredSession,
  type LegacyAuthState as AuthFile,
} from "@polyth/tenancy";
