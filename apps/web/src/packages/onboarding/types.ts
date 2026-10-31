// Package onboarding tour shapes live in contracts (the normative surface);
// web code imports them from here so onboarding modules stay local-path only.
import type {
  PackageOnboardingStep as ContractOnboardingStep,
  PackageOnboardingTour as ContractOnboardingTour,
} from "@polyth/contracts";

export type {
  PackageOnboardingHighlightWhere,
  PackageOnboardingMedia,
} from "@polyth/contracts";

/** A step can send the person to another settings page — the built-in Models
 *  tour points at Harnesses. Web-local: package-registered tours keep the
 *  contract shape and simply have no link. */
export interface PackageOnboardingStepLink {
  /** Settings page id passed to `openSettingsPage`. */
  settingsPage: string;
  label: string;
}

export type PackageOnboardingStep = ContractOnboardingStep & {
  link?: PackageOnboardingStepLink;
};

export type PackageOnboardingTour = Omit<ContractOnboardingTour, "steps"> & {
  steps: PackageOnboardingStep[];
};
