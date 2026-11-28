import "./styles.css";
import { createElement } from "react";
import type { ModelDescriptor } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import {
  notifyModelAnnotationsChanged,
  registerModelAnnotationSource,
} from "@polyth/models/model-annotations";
import { createModelPrivacyCopy } from "./copy.ts";
import { documentLocale, subscribeDocumentLocale } from "./locale.ts";
import ModelPrivacySettings from "./ModelPrivacySettings.tsx";
import {
  getModelPrivacyPrefs,
  replaceModelPrivacyPrefs,
  subscribeModelPrivacyPrefs,
} from "./prefs.ts";
import { privacyAnnotations } from "./presentation.ts";
import PrivacyChip from "./PrivacyChip.tsx";

/**
 * Model privacy: how each free model's provider says it handles what you
 * send, from a dated snapshot of the provider's own page. A quiet mark beside
 * the model's name in Providers & Models and in every model picker (through
 * the models package's annotation seam), the full statement in the model
 * details card, and a chip beside the composer's model when the next turn's
 * model may keep or train on the prompt. Turning the package off removes all
 * of it.
 */
export default defineWebPackage((host) => () => {
  const copy = createModelPrivacyCopy(host.ui.locale.get()).settings;
  const off = [
    host.preferences.register("package.model-privacy", {
      read: getModelPrivacyPrefs,
      write: replaceModelPrivacyPrefs,
      subscribe: subscribeModelPrivacyPrefs,
    }),
    registerModelAnnotationSource({
      id: "model-privacy",
      annotate: (model) => privacyAnnotations(model, documentLocale(), getModelPrivacyPrefs()),
    }),
    subscribeModelPrivacyPrefs(notifyModelAnnotationsChanged),
    subscribeDocumentLocale(notifyModelAnnotationsChanged),
    host.settings.registerPage({
      id: "model-privacy",
      packageId: "model-privacy",
      label: copy.page,
      group: "Engineering",
      icon: "shield",
      order: 37,
      component: ModelPrivacySettings,
      settingsItems: [
        {
          id: "model-privacy.marks",
          pageId: "model-privacy",
          label: copy.all,
          description: copy.searchAll,
          keywords: ["privacy", "retention", "training", "data", "free", "model", "приватність", "дані", "навчання"],
          focusTarget: "model-privacy.marks",
        },
        {
          id: "model-privacy.chip",
          pageId: "model-privacy",
          label: copy.chip,
          description: copy.searchChip,
          keywords: ["privacy", "chip", "composer", "приватність", "чип"],
          focusTarget: "model-privacy.chip",
        },
      ],
    }),
    host.slots.register({
      slot: "composer.config",
      id: "model-privacy.chip",
      order: 22,
      render: (context) => {
        const model = context.model as ModelDescriptor | undefined;
        if (!model || typeof model.providerID !== "string" || typeof model.modelID !== "string") return null;
        return createElement(PrivacyChip, { model });
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
