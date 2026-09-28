'use strict';

// Ролевая фильтрация полного документа перед отдачей клиенту.
// Применяется одинаково к PostgreSQL и json-store (см. readForRole).
// Инвариант: клиент никогда не передаёт ownerId — владение выводится по роли+аккаунту сервера.

const ROLES = ['admin', 'lead', 'pm', 'employee'];

function filterDocByRole(doc, role, accountId) {
  const isAdmin = role === 'admin';
  const isLead = role === 'lead';
  const isPm = role === 'pm';
  const isEmployee = role === 'employee';

  return {
    users: isAdmin ? (doc.users || []) : (isLead ? (doc.users || []).filter((u) => u.ownerId === accountId) : []),
    assessments: isAdmin ? (doc.assessments || []) : (isLead ? (doc.assessments || []).filter((a) => a.ownerId === accountId) : []),
    capacities: isAdmin
      ? (doc.capacities || [])
      : isLead
        ? (doc.capacities || []).filter((c) => c.ownerId === accountId)
        : isPm
          ? (doc.capacities || [])
          : [],
    // Общие сущности / доска:
    projects: isEmployee ? [] : (doc.projects || []),
    managers: isEmployee ? [] : (doc.managers || []),
    skillRegistry: isEmployee ? [] : (doc.skillRegistry || []),
    categories: isEmployee ? [] : (doc.categories || []),
    requests: isAdmin
      ? (doc.requests || [])
      : isLead
        ? (doc.requests || [])
        : isPm
          ? (doc.requests || []).filter((r) => r.createdBy === accountId)
          : [],
  };
}

module.exports = { ROLES, filterDocByRole };