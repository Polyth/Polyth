import { defineWebPackage } from "@polyth/web-sdk";
import coachEntry from "./main.tsx";

export * from "./main.tsx";

/** Canonical package entry: compose the existing Coach UI with project-owned
 * starter metadata. Core seeding consumes Project Context and never hardcodes
 * Coach or its widget ids. */
export default defineWebPackage((host) => {
  const installCoach = coachEntry(host);
  return () => {
    const disposeCoach = installCoach();
    const disposeContext = host.projectContext.register({
      id: "personal-coach.seed",
      order: 34,
      getSnapshot: () => ({
        title: "Personal Coach",
        recommendedWidgetIds: ["personal-coach.today"],
      }),
    });
    return () => {
      disposeContext();
      disposeCoach();
    };
  };
});
