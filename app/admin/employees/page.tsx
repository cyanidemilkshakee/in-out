"use client";

import { useState } from "react";
import { people } from "../../../lib/mockData";
import { AdminPageFrame, PeopleTable } from "../../../components/admin/Tables";

export default function EmployeesPage() {
  const [staff, setStaff] = useState(people);

  function handleToggleInside(personId: string) {
    setStaff((current) =>
      current.map((person) =>
        person.id === personId ? { ...person, inside: !person.inside } : person
      )
    );
  }

  // Filter only employees
  const employees = staff.filter(person => person.type === "employee");

  return (
    <AdminPageFrame
      title="Employee Directory"
      description="Manage employee presence, role-linked access, and checkpoint identity records from the operations data model."
      metric={`${employees.filter((person) => person.inside).length} inside`}
    >
      <PeopleTable 
        title="Employees" 
        people={employees} 
        onToggleInside={handleToggleInside} 
      />
    </AdminPageFrame>
  );
}
