/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Checks whether an error was caused by a timed-out or aborted operation.
 *
 * @param error - The error value to check.
 * @returns Whether the error is a timeout or abort DOMException.
 */
export { getErrorMessage, isTimeoutError } from '../shared/errors';
