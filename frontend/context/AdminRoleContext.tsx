"use client";

import { createContext, useContext, type ReactNode } from "react";

const AdminRoleContext = createContext({ isMasterAdmin: false });

export function AdminRoleProvider({ isMasterAdmin, children }: {
  isMasterAdmin: boolean;
  children: ReactNode;
}) {
  return <AdminRoleContext.Provider value={{ isMasterAdmin }}>{children}</AdminRoleContext.Provider>;
}

export function useAdminRole() {
  return useContext(AdminRoleContext);
}
