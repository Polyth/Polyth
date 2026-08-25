/**
 * Canonical English messages owned by the knowledge package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "common.new": "New",
  "knowledgepanel.ago": "ago",
  "knowledgepanel.all": "All",
  "knowledgepanel.attach": "Attach",
  "knowledgepanel.attachedToSession": "Attached to session",
  "knowledgepanel.bodyMarkdownWelcome": "Body (Markdown welcome)",
  "knowledgepanel.distillTheCurrentSessionIntoANote": "Distill the current session into a note draft (small model) — you review before saving",
  "knowledgepanel.distilling": "Distilling…",
  "knowledgepanel.editingRevision": "Editing revision",
  "knowledgepanel.fromChat": "From chat",
  "knowledgepanel.logThisExactRevisionIntoTheCurrent": "Log this exact revision into the current session",
  "knowledgepanel.memory": "Memory",
  "knowledgepanel.moreNotShownRefineYourSearch": "more not shown — refine your search.",
  "knowledgepanel.newKnowledgeItem": "New knowledge item",
  "knowledgepanel.noKnowledgeYetCaptureNotesPlansOr": "No knowledge yet. Capture notes, plans, or memory for this project.",
  "knowledgepanel.noMatches": "No matches.",
  "knowledgepanel.note": "Note",
  "knowledgepanel.notes": "Notes",
  "knowledgepanel.openAProjectToKeepNotesPlans": "Open a project to keep notes, plans, and memory.",
  "knowledgepanel.plan": "Plan",
  "knowledgepanel.plans": "Plans",
  "knowledgepanel.rev": "rev",
  "knowledgepanel.savingBumpsIt": "; saving bumps it.",
  "knowledgepanel.searchKnowledge": "Search knowledge…",
  "knowledgepanel.spec": "Spec",
  "knowledgepanel.specs": "Specs",
  "knowledgepanel.tagsCommaSeparated": "Tags, comma separated",
  "knowledgepanel.title": "Title",
  "packages.knowledge.executeASavedFeatureSpecOneTested": "Execute a saved feature spec one tested commit at a time.",
  "packages.knowledge.tracks": "Tracks",
} as const;

export type KnowledgeMessageKey = keyof typeof en;
export type KnowledgeMessages = Record<KnowledgeMessageKey, string>;
