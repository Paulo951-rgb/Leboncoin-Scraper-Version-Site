'use strict';

const { ALL_FIELD_KEYS } = require('./exportFields');

// Profil Défaut : champs essentiels pour un scraping rapide et léger
const DEFAULT_PROFILE_FIELDS = [
  'id', 'title', 'url', 'prix',
  'ville', 'codePostal',
  'deliveryType',
  'datePublication', 'dateScraping',
  'vendeurNom', 'vendeurType',
  'photosCount',
  'description',
];

// Profil Maximum : toutes les données disponibles
const MAXIMUM_PROFILE_FIELDS = [...ALL_FIELD_KEYS];

// Profil Personnalisé : choisi par l'utilisateur
// Stocké en localStorage côté renderer, transmis au main process

const PROFILES = {
  default: {
    id: 'default',
    label: 'Défaut',
    description: 'Récupération des données essentielles pour un scraping rapide et léger.',
    fields: DEFAULT_PROFILE_FIELDS,
  },
  maximum: {
    id: 'maximum',
    label: 'Maximum',
    description: 'Récupération de toutes les données disponibles techniquement.',
    fields: MAXIMUM_PROFILE_FIELDS,
  },
  custom: {
    id: 'custom',
    label: 'Personnalisé',
    description: 'Choisissez exactement les champs à récupérer.',
    fields: null, // Défini par l'utilisateur
  },
};

function getProfileFields(profileId, customFields) {
  if (profileId === 'custom') {
    if (!customFields || !Array.isArray(customFields) || customFields.length === 0) {
      return DEFAULT_PROFILE_FIELDS;
    }
    return customFields.filter((k) => ALL_FIELD_KEYS.includes(k));
  }
  return PROFILES[profileId]?.fields || DEFAULT_PROFILE_FIELDS;
}

function getProfileLabel(profileId) {
  return PROFILES[profileId]?.label || 'Défaut';
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE_FIELDS,
  MAXIMUM_PROFILE_FIELDS,
  getProfileFields,
  getProfileLabel,
};
