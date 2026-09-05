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

/**
 * One card's conversation, for triage (`prd.md` R38). The issue and the one pull request the card is showing are asked
 * for together because they are one question — what is this card asking for — and two round trips would double the
 * cost of a cold start. `mergeStateStatus`, `statusCheckRollup` and `reviewThreads` need no preview header
 * (`docs/mechanics.md` §31); `reviews` and `reviewRequests` are what tell a first review round from a later one, and
 * a colleague's pull request awaiting the developer from their own.
 */
export const CARD_CONTEXT_QUERY = `
query($owner:String!, $name:String!, $issue:Int!, $pr:Int!, $withPr:Boolean!){
  repository(owner:$owner, name:$name){
    issue(number:$issue){
      number title body
      comments(last:5){ nodes{ body createdAt authorAssociation author{ login } } }
    }
    pullRequest(number:$pr) @include(if:$withPr){
      number title body state isDraft
      author{ login }
      reviewDecision mergeable mergeStateStatus
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      comments(last:5){ nodes{ body createdAt authorAssociation author{ login } } }
      reviews(last:20){ nodes{ state submittedAt author{ login } } }
      reviewRequests(first:10){ nodes{ requestedReviewer{
        ... on User{ login }
        ... on Team{ slug }
      }}}
      reviewThreads(last:5){ nodes{
        isResolved isOutdated
        comments(first:3){ nodes{ body createdAt authorAssociation author{ login } } }
      }}
    }
  }
}`;
