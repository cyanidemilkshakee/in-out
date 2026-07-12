"use client";

import { useState } from "react";
import { people } from "../../../lib/mockData";
import { AdminPageFrame, PeopleTable, TemporaryVisitorCreator } from "../../../components/admin/Tables";
import type { Person } from "../../../lib/types";

export default function VisitorsPage() {
  const [staff, setStaff] = useState(people);

  function handleToggleInside(personId: string) {
    setStaff((current) =>
      current.map((person) =>
        person.id === personId ? { ...person, inside: !person.inside } : person
      )
    );
  }

  function handleCreateVisitor(visitor: Person) {
    setStaff((current) => [visitor, ...current]);
  }

  // Filter only visitors
  const visitors = staff.filter(person => person.type === "visitor");

  return (
    <AdminPageFrame
      title="Visitor Access"
      description="Issue temporary passes, inspect host approvals, and keep visitor identities aligned with the movement ledger."
      metric={`${visitors.filter((person) => person.status === "pre_approved").length} pre-approved`}
    >
      <PeopleTable 
        title="Visitors" 
        people={visitors} 
        onToggleInside={handleToggleInside}
        action={<TemporaryVisitorCreator onCreate={handleCreateVisitor} />}
      />
    </AdminPageFrame>
  );
}
