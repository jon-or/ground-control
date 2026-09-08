/**
 * `cards` is the filtered set the board renders; `assignedTotal` is the same search without the project
 * qualifier, so the board can say how many assigned issues the filter excluded rather than hiding them.
 */
/**
 * What both issue reads select. Shared verbatim, because `toCard` maps one shape: a field the by-number read stopped
 * asking for would be a card that quietly lost its status the moment nobody was assigned to it.
 *
 * `closedByPullRequestsReferences` is how a card finds its pull request at all — an issue node carries no other link
 * to one. Five of them, because `selectPullRequest` returns exactly one and GraphQL bills the nodes asked for, not
 * the nodes returned: the `commits` selection inside costs 8 points at `first:5` and 103 at `first:100`
 * (`docs/mechanics.md` §48). `statusCheckRollup` is there so a build going red moves the card's evidence, which is
 * the one change a card can undergo that nothing else here reports (R24).
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
    project{ number }
    fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name color updatedAt } }
  }}`;

export const ASSIGNED_ISSUES_QUERY = `
query($cards:String!, $all:String!, $after:String){
  cards: search(query:$cards, type:ISSUE, first:100, after:$after){
    issueCount
    pageInfo{ hasNextPage endCursor }
    nodes{ ... on Issue{${ISSUE_FIELDS}
    }}
  }
  assignedTotal: search(query:$all, type:ISSUE, first:1){ issueCount }
}`;

/**
 * One issue by number, for a session naming work the assigned search did not return — an issue finished and handed
 * on, or one that was never the developer's. The card it builds is the same shape the search builds, minus nothing.
 */
export const ISSUE_BY_NUMBER_QUERY = `
query($owner:String!, $name:String!, $number:Int!){
  repository(owner:$owner, name:$name){
    issue(number:$number){${ISSUE_FIELDS}
    }
  }
}`;

/**
 * One card's conversation, for triage (`prd.md` R38). The issue and the one pull request the card is showing are asked
 * for together because they are one question — what is this card asking for — and two round trips would double the
 * cost of a cold start. `statusCheckRollup` and `reviewThreads` need no preview header
 * (`docs/mechanics.md` §31); `reviews` and `reviewRequests` are what tell a first review round from a later one, and
 * a colleague's pull request awaiting the developer from their own. The `profile` fragment resolves to nothing on
 * a bot — `claude` and `github-actions` are not `User` — so those keep the login the board already had.
 *
 * `timelineItems` is what says when the card became what it is: on this team's board a status names the work and the
 * assignee names who does it, so a move with no comment on it is still an instruction (`docs/mechanics.md` §32).
 *
 * `defaultBranchRef` and `baseRefName` are what decide whether keeping a branch current is one merge or a chain, and
 * `oid` is the head commit a run's evidence carries, which is what authorises one run per push (R39). GitHub's own
 * mergeability is not asked for: a merge is something somebody requests, and whether one happened is the run's own
 * report, so nothing on this board is decided by it.
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
        ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ login ...profile } previousStatus status project{ number } }
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
