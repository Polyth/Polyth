import { defineWebPackage } from "@polyth/web-sdk";
import coachEntry from "./index.tsx";

/** Compose the existing Coach UI with project-owned seed metadata. The core
 * workspace seeder consumes this through Project Context; it never hardcodes
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
