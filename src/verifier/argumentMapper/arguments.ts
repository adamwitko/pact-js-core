import logger from '../../logger';
import fs = require('fs');
import url = require('url');

import { FnMapping, FnValidationStatus } from './types';
import { InternalPactVerifierOptions } from '../types';

import { FfiVerificationFunctions } from '../../ffi/types';
import { URL } from 'url';

const DEFAULT_TIMEOUT = 30000;

const objArrayToStringArray = (obj: unknown[]) => {
  return obj.map((o) => JSON.stringify(o));
};

export type IgnoredFfiFunctions = {
  pactffiVerifierNewForApplication: 1;
  pactffiVerifierExecute: 1;
  pactffiVerifierShutdown: 1;
};

export type OrderedExecution = {
  [Key in keyof RequiredFfiVerificationFunctions]: number;
};

export const orderOfExecution: OrderedExecution = {
  pactffiVerifierSetProviderInfo: 1,
  pactffiVerifierSetFilterInfo: 2,
  pactffiVerifierSetProviderState: 3,
  pactffiVerifierSetVerificationOptions: 4,
  pactffiVerifierSetPublishOptions: 5,
  pactffiVerifierSetConsumerFilters: 6,
  pactffiVerifierAddCustomHeader: 7,
  pactffiVerifierAddDirectorySource: 8,
  pactffiVerifierBrokerSourceWithSelectors: 9,
};

export type MergedFfiSourceFunctions = {
  pactffiVerifierAddFileSource: 1;
  pactffiVerifierUrlSource: 1;
};

export type RequiredFfiVerificationFunctions = Omit<
  FfiVerificationFunctions,
  keyof (IgnoredFfiFunctions & MergedFfiSourceFunctions)
>;

export const ffiFnMapping: FnMapping<
  RequiredFfiVerificationFunctions,
  InternalPactVerifierOptions
> = {
  pactffiVerifierAddCustomHeader: {
    validateAndExecute(ffi, handle, options) {
      const messages: string[] = [];

      if (options.customProviderHeaders) {
        if (Array.isArray(options.customProviderHeaders)) {
          options.customProviderHeaders.forEach((item) => {
            const parts = item.split(':');
            if (parts.length !== 2) {
              messages.push(
                `${item} is not a valid custom header. Must be in the format 'Header-Name: Value'`
              );
            } else {
              ffi.pactffiVerifierAddCustomHeader(handle, parts[0], parts[1]);
            }
          });
        } else {
          if (options.customProviderHeaders) {
            Object.entries(options.customProviderHeaders).forEach(
              ([key, value]) => {
                ffi.pactffiVerifierAddCustomHeader(handle, key, value);
              }
            );
          }
        }
        if (messages.length > 0) {
          return { status: FnValidationStatus.FAIL };
        }

        return { status: FnValidationStatus.SUCCESS };
      }

      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierAddDirectorySource: {
    validateAndExecute(ffi, handle, options) {
      const messages: string[] = [];

      if (options.pactUrls) {
        options.pactUrls.forEach((file) => {
          logger.debug(`checking source type of given pactUrl: ${file}`);

          if (/https?:/.test(url.parse(file).protocol || '')) {
            try {
              const u = new URL(file);

              if (u.hostname) {
                logger.debug(`adding ${file} as a Url source`);
                ffi.pactffiVerifierUrlSource(
                  handle,
                  file,
                  options.pactBrokerUsername ||
                    process.env.PACT_BROKER_USERNAME ||
                    '',
                  options.pactBrokerPassword ||
                    process.env.PACT_BROKER_PASSWORD ||
                    '',
                  options.pactBrokerToken || process.env.PACT_BROKER_TOKEN || ''
                );
              }
            } catch {
              messages.push(`${file} is not a valid URL`);
            }
          } else {
            try {
              const f = fs.lstatSync(file);

              if (f.isDirectory()) {
                logger.debug(`adding ${file} as Directory source`);
                ffi.pactffiVerifierAddDirectorySource(handle, file);
              } else if (f.isFile() || f.isSymbolicLink()) {
                logger.debug(`adding ${file} as File source`);
                ffi.pactffiVerifierAddFileSource(handle, file);
              }
            } catch {
              messages.push(
                `'${file}' does not exist, or is not a file or directory`
              );
            }
          }
        });

        if (messages.length > 0) {
          return { status: FnValidationStatus.FAIL, messages };
        }

        return { status: FnValidationStatus.SUCCESS };
      }

      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierBrokerSourceWithSelectors: {
    validateAndExecute(ffi, handle, opts) {
      const brokerUrl = opts.pactBrokerUrl || process.env.PACT_BROKER_BASE_URL;

      if (brokerUrl && opts.provider) {
        ffi.pactffiVerifierBrokerSourceWithSelectors(
          handle,
          brokerUrl,
          opts.pactBrokerUsername || process.env.PACT_BROKER_USERNAME || '',
          opts.pactBrokerPassword || process.env.PACT_BROKER_PASSWORD || '',
          opts.pactBrokerToken || process.env.PACT_BROKER_TOKEN || '',
          opts.enablePending || false,
          opts.includeWipPactsSince || '',
          opts.providerVersionTags || [],
          opts.providerVersionBranch || opts.providerBranch || '',
          opts.consumerVersionSelectors
            ? objArrayToStringArray(opts.consumerVersionSelectors)
            : [],
          opts.consumerVersionTags || []
        );
        return { status: FnValidationStatus.SUCCESS };
      }
      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierSetConsumerFilters: {
    validateAndExecute(ffi, handle, options) {
      if (options.consumerFilters && options.consumerFilters.length > 0) {
        ffi.pactffiVerifierSetConsumerFilters(handle, options.consumerFilters);
        return { status: FnValidationStatus.SUCCESS };
      }
      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierSetFilterInfo: {
    validateAndExecute(ffi, handle) {
      if (
        process.env.PACT_DESCRIPTION ||
        process.env.PACT_PROVIDER_STATE ||
        process.env.PACT_PROVIDER_NO_STATE
      ) {
        const filterDescription = process.env.PACT_DESCRIPTION || '';
        const filterState = process.env.PACT_PROVIDER_STATE || '';
        const filterNoState = process.env.PACT_PROVIDER_NO_STATE ? true : false;

        ffi.pactffiVerifierSetFilterInfo(
          handle,
          filterDescription,
          filterState,
          filterNoState
        );

        return { status: FnValidationStatus.SUCCESS };
      }

      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierSetProviderInfo: {
    validateAndExecute(ffi, handle, options) {
      const uri = new URL(options.providerBaseUrl);

      ffi.pactffiVerifierSetProviderInfo(
        handle,
        options.provider || '',
        uri.protocol.split(':')[0],
        uri.hostname,
        parseInt(uri.port, 10),
        uri.pathname
      );

      return { status: FnValidationStatus.SUCCESS };
    },
  },
  pactffiVerifierSetProviderState: {
    validateAndExecute(ffi, handle, options) {
      if (options.providerStatesSetupUrl) {
        ffi.pactffiVerifierSetProviderState(
          handle,
          options.providerStatesSetupUrl,
          true,
          true
        );
        return { status: FnValidationStatus.SUCCESS };
      }

      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierSetPublishOptions: {
    validateAndExecute(ffi, handle, options) {
      if (
        (options.publishVerificationResult ||
          process.env.PACT_BROKER_PUBLISH_VERIFICATION_RESULTS) &&
        options.providerVersion
      ) {
        ffi.pactffiVerifierSetPublishOptions(
          handle,
          options.providerVersion,
          options.buildUrl || '',
          options.providerVersionTags || [],
          options.providerVersionBranch || options.providerBranch || ''
        );
        return { status: FnValidationStatus.SUCCESS };
      }
      return { status: FnValidationStatus.IGNORE };
    },
  },
  pactffiVerifierSetVerificationOptions: {
    validateAndExecute(ffi, handle, opts) {
      if (opts.disableSslVerification || opts.timeout) {
        ffi.pactffiVerifierSetVerificationOptions(
          handle,
          opts.disableSslVerification || false,
          opts.timeout || DEFAULT_TIMEOUT
        );
        return { status: FnValidationStatus.SUCCESS };
      }

      return { status: FnValidationStatus.IGNORE };
    },
  },
};
