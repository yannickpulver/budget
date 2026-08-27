// Shared column layout for the holdings header, rows, and the add-holding row.
// Below `md` only Symbol and Value survive; Name/Quantity/Price are
// `hidden md:block`, so they don't occupy a grid cell on a phone.
export const HOLDINGS_GRID =
  "grid grid-cols-[1fr_auto] items-center gap-x-2 md:grid-cols-[7rem_1fr_7rem_8rem_8rem_2.5rem]";
