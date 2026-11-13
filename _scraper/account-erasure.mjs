// Shared pure cleanup helpers; forum identity access runs only in Cloud Functions.
import helpers from '../_functions/account-erasure.js';
export const { eraseTree, eraseUploads, eraseForum } = helpers;
