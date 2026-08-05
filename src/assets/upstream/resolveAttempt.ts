/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The shared one-attempt asset resolver is exported from the asset delivery
 * implementation while the remaining coordinator policy is kept in the DO.
 */
export { resolveDirect as resolveAttempt } from '../../services/assets/delivery';
