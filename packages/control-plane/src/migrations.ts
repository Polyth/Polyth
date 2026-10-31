// Historical migration bytes are immutable; append new versions here.
import { migrations as v1 } from './schema.ts';
import { securityMigration } from './securityMigration.ts';
import { passkeyMigration } from './passkeyMigration.ts';
import { providerMigration } from './providerMigration.ts';
import { providerLinkMigration } from './providerLinkMigration.ts';
import { domainMigration } from './domainMigration.ts';
import { runtimeSystemMigration } from './runtimeSystemMigration.ts';
import { accountGuardrailsMigration } from './accountGuardrailsMigration.ts';
import { accountLimitsMigration } from './accountLimitsMigration.ts';
import { cliAccessMigration } from './cliAccessMigration.ts';
import { accountPermissionsMigration } from './accountPermissionsMigration.ts';
import { sharingMigration } from './sharingMigration.ts';
import { localAccessMigration } from './localAccessMigration.ts';
export const migrations = [
  ...v1,
  securityMigration,
  passkeyMigration,
  providerMigration,
  providerLinkMigration,
  domainMigration,
  runtimeSystemMigration,
  accountGuardrailsMigration,
  accountLimitsMigration,
  cliAccessMigration,
  accountPermissionsMigration,
  sharingMigration,
  localAccessMigration,
];
