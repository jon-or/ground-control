/**
 * `cards` is the filtered set the board renders; `assignedTotal` is the same search without the project
 * qualifier, so the board can say how many assigned issues the filter excluded rather than hiding them.
 */
export const ASSIGNED_ISSUES_QUERY = `
query($cards:String!, $all:String!, $after:String){
  cards: search(query:$cards, type:ISSUE, first:100, after:$after){
    issueCount
    pageInfo{ hasNextPage endCursor }
    nodes{ ... on Issue{
      number title url updatedAt
      issueType{ name color }
      repository{ nameWithOwner }
      assignees(first:10){ nodes{ login avatarUrl(size:40) } }
      pullRequests: closedByPullRequestsReferences(first:100){ nodes{
        number url state updatedAt isDraft reviewDecision
        author{ login avatarUrl(size:40) }
      }}
      projectItems(first:20){ nodes{
        project{ number }
        fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name color } }
      }}
    }}
  }
  assignedTotal: search(query:$all, type:ISSUE, first:1){ issueCount }
}`;
