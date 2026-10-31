import { useState } from "react";
import { Icon } from "../icons.tsx";
import type { ProfileAccount } from "../profileAccount.ts";

/** The signed-in GitHub account's picture; the local account icon when there
 *  is no account or the picture does not load (offline, blocked, a busy CDN). */
export default function ProfileAvatar({ user }: { user: ProfileAccount | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!user || broken === user.avatarUrl) return <Icon.session />;
  return <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(user.avatarUrl)} />;
}
