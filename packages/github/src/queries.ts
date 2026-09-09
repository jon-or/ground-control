/** cards applies the project filter; assignedTotal omits it to count excluded assigned issues. */
/**
 * Shared card fields: five closing PRs bound cost (M48), statusCheckRollup feeds triage, $status names the status
 * field, and the project's field(name:) lookup tells a missing or differently typed field from an unset value.
 */
const ISSUE_FIELDS = `
  number title url state updatedAt
  issueType{ name color }
  repository{ nameWithOwner }
  assignees(first:10){ nodes{ login avatarUrl(size:40) } }
  pullRequests: closedByPullRequestsReferences(first:5){ nodes{
    number url state updatedAt isDraft reviewDecision
    author{ login avatarUrl(size:40) }
    commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } }
  }}
  projectItems(first:20){ nodes{
    project{ number owner{ ... on Organization{ login } ... on User{ login } } field(name:$status){ __typename } }
    fieldValueByName(name:$status){ ... on ProjectV2ItemFieldSingleSelectValue{ name color updatedAt } }
  }}`;

export const ASSIGNED_ISSUES_QUERY = `
query($cards:String!, $all:String!, $status:String!, $after:String){
  cards: search(query:$cards, type:ISSUE, first:100, after:$after){
    issueCount
    pageInfo{ hasNextPage endCursor }
    nodes{ ... on Issue{${ISSUE_FIELDS}
    }}
  }
  assignedTotal: search(query:$all, type:ISSUE, first:1){ issueCount }
}`;

/** Read issues absent from the assigned search with the same card fields. */
export const ISSUE_BY_NUMBER_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $status:String!){
  repository(owner:$owner, name:$name){
    issue(number:$number){${ISSUE_FIELDS}
    }
  }
}`;

/**
 * Fetch issue and selected-PR context together for triage. Timeline events identify status and assignment
 * instructions (mechanics M32); reviews and requests determine ownership and review round. User profile fields
 * do not resolve for bots. Default/base branches and head OID support fresh action authorization; mergeability
 * does not establish a merge request (R39).
 */
export const CARD_CONTEXT_QUERY = `
query($owner:String!, $name:String!, $issue:Int!, $pr:Int!, $withPr:Boolean!){
  repository(owner:$owner, name:$name){
    defaultBranchRef{ name }
    issue(number:$issue){
      number title body
      comments(last:5){ nodes{ body createdAt authorAssociation author{ login ...profile } } }
      timelineItems(last:100, itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){ nodes{
        __typename
        ... on AssignedEvent{ createdAt actor{ login ...profile } assignee{ ... on User{ login } } }
        ... on UnassignedEvent{ createdAt actor{ login ...profile } assignee{ ... on User{ login } } }
        ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ login ...profile } previousStatus status project{ number owner{ ... on Organization{ login } ... on User{ login } } } }
      }}
    }
    pullRequest(number:$pr) @include(if:$withPr){
      number title body state isDraft
      author{ login ...profile }
      baseRefName headRefName
      commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } }
      comments(last:5){ nodes{ body createdAt authorAssociation author{ login ...profile } } }
      reviews(last:20){ nodes{ state submittedAt author{ login ...profile } } }
      reviewRequests(first:10){ nodes{ requestedReviewer{
        ... on User{ login name }
        ... on Team{ slug }
      }}}
      reviewThreads(last:5){ nodes{
        isResolved isOutdated
        comments(first:3){ nodes{ body createdAt authorAssociation author{ login ...profile } } }
      }}
    }
  }
}

fragment profile on User{ name }`;
