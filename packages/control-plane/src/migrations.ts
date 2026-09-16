// Historical migration bytes are immutable; append new versions here.
import { migrations as v1 } from './schema.ts';
import { securityMigration } from './securityMigration.ts';
import { passkeyMigration } from './passkeyMigration.ts';
import { providerMigration } from './providerMigration.ts';
import { providerLinkMigration } from './providerLinkMigration.ts';
import { domainMigration } from './domainMigration.ts';
export const migrations = [...v1, securityMigration, passkeyMigration, providerMigration, providerLinkMigration, domainMigration];
