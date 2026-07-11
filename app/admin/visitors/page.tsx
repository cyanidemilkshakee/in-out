"use client";

import { useState } from "react";
import { people } from "../../../lib/mockData";
import { PeopleTable } from "../../../components/admin/Tables";

export default function VisitorsPage() {
  const [staff, setStaff] = useState(people);

  function handleToggleInside(personId: string) {
    setStaff((current) =>
      current.map((person) =>
        person.id === personId ? { ...person, inside: !person.inside } : person
      )
    );
  }

  // Filter only visitors
  const visitors = staff.filter(person => person.type === "visitor");

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <PeopleTable 
        title="Visitors" 
        people={visitors} 
        onToggleInside={handleToggleInside} 
      />
    </div>
  );
}
