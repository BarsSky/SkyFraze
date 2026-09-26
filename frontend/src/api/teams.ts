import { http } from './client'

export interface TeamMember {
  project_id: string
  user_id: string
  role: 'owner' | 'editor' | 'viewer'
  added_at: string
  email?: string
  display_name?: string
}

export interface Invitation {
  id: string
  project_id: string
  email: string
  role: 'editor' | 'viewer'
  token: string
  invited_by: string
  expires_at: string
  accepted_at?: string
  created_at: string
}

export async function listMembers(projectId: string): Promise<TeamMember[]> {
  return await http.get(`projects/${projectId}/members`).json<TeamMember[]>()
}

export async function invite(projectId: string, email: string, role: 'editor' | 'viewer'): Promise<Invitation> {
  return await http.post(`projects/${projectId}/invitations`, { json: { email, role } }).json<Invitation>()
}

export async function acceptInvitation(token: string): Promise<TeamMember> {
  return await http.post(`invitations/${token}/accept`).json<TeamMember>()
}
